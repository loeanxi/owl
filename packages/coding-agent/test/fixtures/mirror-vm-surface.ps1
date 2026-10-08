param([Parameter(Mandatory=$true)][string]$WorkerPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$source=[IO.File]::ReadAllText($WorkerPath)
$interop=[regex]::Match($source,"(?s)\`$user32 = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
Add-Type -TypeDefinition $interop
[OwlMirrorWin32]::SetThreadDpiAwarenessContext([IntPtr](-4))|Out-Null
$directory=Join-Path ([IO.Path]::GetTempPath()) ('owl-vm-surface-'+[Guid]::NewGuid())
New-Item -ItemType Directory -Path $directory|Out-Null
$vmSource=@'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class VmSurfaceFixture {
  delegate IntPtr Procedure(IntPtr hwnd,uint msg,UIntPtr wp,IntPtr lp);
  static readonly Procedure procedure=DefWindowProc;
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct WindowClass {
    public uint style;
    public Procedure proc;
    public int classBytes,windowBytes;
    public IntPtr instance,icon,cursor,background;
    public string menu,name;
  }
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern ushort RegisterClass(ref WindowClass cls);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint ex,string cls,string title,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr arg);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr DefWindowProc(IntPtr hwnd,uint msg,UIntPtr wp,IntPtr lp);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [STAThread] public static void Main(string[] args) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    WindowClass cls=new WindowClass();
    cls.proc=procedure; cls.instance=GetModuleHandle(null); cls.name="subWin";
    if(RegisterClass(ref cls)==0) throw new Exception("Cannot register fixture surface");
    IntPtr hwnd=CreateWindowEx(0,"subWin","Android surface",0x50000000,0,60,1500,939,new IntPtr(long.Parse(args[0])),IntPtr.Zero,cls.instance,IntPtr.Zero);
    if(hwnd==IntPtr.Zero) throw new Exception("Cannot create fixture surface");
    File.WriteAllText(args[1],hwnd.ToInt64().ToString());
    Application.Run();
  }
}
'@
$executable=Join-Path $directory 'AndrowsVm.exe'
Add-Type -TypeDefinition $vmSource -OutputAssembly $executable -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms
$hostWindow=New-Object System.Windows.Forms.Form
$hostWindow.FormBorderStyle='None'
$hostWindow.StartPosition='Manual'
$hostWindow.ShowInTaskbar=$false
$hostWindow.SetBounds(-8000,-8000,906,547)
$hostHandle=$hostWindow.Handle
$decoy=New-Object System.Windows.Forms.Panel
$decoy.SetBounds(0,0,2000,1600)
$hostWindow.Controls.Add($decoy)
$decoyHandle=$decoy.Handle
$surface=New-Object OwlMirrorWin32+RECT
if([OwlMirrorWin32]::TryAndroidSurface($hostHandle,[ref]$surface)){throw 'An ordinary control was mistaken for the VM'}
$handlePath=Join-Path $directory 'surface.txt'
$vm=$null
try {
  $vm=Start-Process -FilePath $executable -ArgumentList @($hostHandle.ToInt64(),$handlePath) -WindowStyle Hidden -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(5)
  while(-not(Test-Path -LiteralPath $handlePath)){
    [System.Windows.Forms.Application]::DoEvents()
    if($vm.HasExited -or [DateTime]::UtcNow -gt $deadline){throw 'VM fixture did not start'}
    Start-Sleep -Milliseconds 20
  }
  if(-not[OwlMirrorWin32]::TryAndroidSurface($hostHandle,[ref]$surface)){throw 'VM surface was not found'}
  if($surface.Right-$surface.Left -ne 1500 -or $surface.Bottom-$surface.Top -ne 939){throw 'VM surface dimensions were truncated'}
  $required=[OwlMirrorWin32]::RequiredSurfaceWindowRect($hostHandle,$surface)
  if($required.Right-$required.Left -ne 1500 -or $required.Bottom-$required.Top -ne 999){throw 'Host did not include the complete VM surface'}
  $hostWindow.SetBounds(-8000,-8000,1500,999)
  [System.Windows.Forms.Application]::DoEvents()
  $bounds=[OwlMirrorWin32]::ReadProjectionBounds($hostHandle,1.5)
  if($bounds.Crop.Right-$bounds.Crop.Left -ne 1500 -or $bounds.Crop.Bottom-$bounds.Crop.Top -ne 939){throw 'Projection crop used the fixed profile instead of the VM'}
  if($bounds.Crop.Left-$bounds.ClientOffset.X -ne 0 -or $bounds.Crop.Top-$bounds.ClientOffset.Y -ne 60){throw 'VM crop changed root-client input coordinates'}
  $vmHandle=[IntPtr]([long][IO.File]::ReadAllText($handlePath))
  [OwlMirrorWin32]::ShowWindow($vmHandle,0)|Out-Null
  if(([OwlMirrorWin32]::GetStyle($vmHandle) -band 0x10000000) -ne 0){throw 'Fixture VM was not hidden'}
  if(-not[OwlMirrorWin32]::TryAndroidSurface($hostHandle,[ref]$surface)){throw 'Hidden trusted VM dimensions were lost'}
  $hiddenBounds=[OwlMirrorWin32]::ReadProjectionBounds($hostHandle,1.5)
  if($hiddenBounds.Crop.Right-$hiddenBounds.Crop.Left -ne 1500 -or $hiddenBounds.Crop.Bottom-$hiddenBounds.Crop.Top -ne 939){throw 'Hidden VM fell back to the fixed profile'}

  # Exercise the production restore normalization without restoring/moving a
  # user window. A larger working host must not inflate an already-valid record.
  $tokens=$null; $parseErrors=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$parseErrors)
  $restoreHelper=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Ensure-MirrorRestoreSurface'},$true)
  . ([scriptblock]::Create($restoreHelper.Extent.Text))
  $hostWindow.SetBounds(-8000,-8000,1900,1200)
  [System.Windows.Forms.Application]::DoEvents()
  $small=@{x=123;y=456;width=906;height=547;style=17;owner=23}
  $expanded=Ensure-MirrorRestoreSurface $hostHandle $small
  if($expanded.width -ne 1500 -or $expanded.height -ne 999 -or $expanded.x -ne 123 -or $expanded.y -ne 456 -or $expanded.style -ne 17 -or $expanded.owner -ne 23){throw 'Restore normalization changed fields beyond the missing content dimensions'}
  $enough=@{x=321;y=654;width=1600;height=1050;style=17;owner=23}
  $preserved=Ensure-MirrorRestoreSurface $hostHandle $enough
  if($preserved.width -ne 1600 -or $preserved.height -ne 1050 -or $preserved.x -ne 321 -or $preserved.y -ne 654){throw 'A valid original restore rectangle was changed'}
  Write-Output 'vm-surface-ok'
} finally {
  if($vm -and -not $vm.HasExited){$vm.Kill();$vm.WaitForExit(3000)|Out-Null}
  $hostWindow.Dispose()
  Get-ChildItem -LiteralPath $directory -File|ForEach-Object {Remove-Item -LiteralPath $_.FullName}
  Remove-Item -LiteralPath $directory
}
